import os from 'os';
import fs from 'fs';
import path from 'path';

// Known install targets checked ahead of process.env.PATH. On fresh Linux
// installs, the Node process inherits a restricted PATH that doesn't yet
// include ~/.cargo/bin — so every cargo-installed or prebuilt-downloaded
// binary (nak, ngit, nostr-rs-relay, nvpn) reads as "not installed" until
// the user opens a new login shell. Walking a curated dir list catches
// them regardless of shell state.
function augmentedBinDirs(): string[] {
  const home = os.homedir();
  return [
    `${home}/.cargo/bin`,    // cargo install target + our prebuilt drop dir
    `${home}/.local/bin`,    // pipx / manual installs
    '/opt/homebrew/bin',     // Apple Silicon Homebrew
    '/usr/local/bin',        // Intel Homebrew + common manual installs
    '/usr/bin',
    '/bin',
  ];
}

export function findBin(name: string): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // Curated dirs first so we don't care what the calling shell had on PATH.
  for (const dir of [...augmentedBinDirs(), ...pathDirs]) {
    const abs = path.join(dir, name);
    try {
      fs.accessSync(abs, fs.constants.X_OK);
      return abs;
    } catch { /* not there, keep looking */ }
  }
  return null;
}

export function hasBin(name: string): boolean {
  return findBin(name) !== null;
}

// Resolve the Rust-target triple upstream (mmalmi/nostr-vpn) publishes
// per (os, arch). Linux builds are statically linked against musl so they
// run on any distro without glibc-version pins — there is NO `-gnu` asset.
// macOS x86_64 is unsupported upstream — installer surfaces a clear error
// rather than 404'ing on the download URL.
export function getNvpnTarget(): string | null {
  const arch = process.arch;
  if (process.platform === 'darwin') {
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    return null;  // x86_64-apple-darwin: upstream does not publish this asset
  }
  if (process.platform === 'linux') {
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
    if (arch === 'x64')   return 'x86_64-unknown-linux-musl';
  }
  return null;
}

// User-writable install dir for binaries we drop in by hand (nvpn). Same
// path cargo uses, so anything that already had cargo-installed tools on
// PATH gets the new binary on PATH too.
export function getCargoBin(): string {
  return path.join(os.homedir(), '.cargo', 'bin');
}


// Probe local AI servers — called during config phase
// Returns available models or null if the server isn't running
export async function probeOllama(base = 'http://localhost:11434'): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as { models?: { name: string }[] };
    return data.models?.map(m => m.name) ?? [];
  } catch { return null; }
}

export async function probeLmStudio(base = 'http://localhost:1234'): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string }[] };
    return data.data?.map(m => m.id) ?? [];
  } catch { return null; }
}

// Maple Proxy runs on localhost:8080 by default (same port as our relay!)
// It supports a /health endpoint — probe that to detect it
export async function probeMaple(base = 'http://localhost:8081'): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
