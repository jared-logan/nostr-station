import os from 'os';
import fs from 'fs';
import path from 'path';

export type OS = 'macos' | 'linux';
export type Arch = 'aarch64' | 'x86_64';
export type ServiceBackend = 'launchd' | 'systemd';
export type PkgMgr = 'brew' | 'apt' | 'dnf' | 'pacman';

export interface Platform {
  os: OS;
  arch: Arch;
  pkgMgr: PkgMgr;
  serviceBackend: ServiceBackend;
  nvpnTarget: string;
  homeDir: string;
  cargoBin: string;
  logDir: string;
  scriptsDir: string;
  projectsDir: string;
  configDir: string;
  relayDataDir: string;
  launchAgentsDir?: string;
}

export type Editor = 'claude-code' | 'cursor' | 'windsurf' | 'copilot' | 'aider' | 'codex' | 'other';
export type VersionControl = 'ngit' | 'github' | 'both';

export interface Config {
  npub: string;
  hexPubkey: string;
  bunker: string;
  relayName: string;
  fallbackRelays: string;
  aiProvider: 'anthropic' | 'openrouter' | 'routstr' | 'ppq' | 'ollama' | 'lmstudio' | 'opencode-zen' | 'maple' | 'custom';
  openrouterKey?: string;
  openrouterModel?: string;
  routstrCashuToken?: string;
  routstrServer?: string;
  ppqApiKey?: string;
  ollamaModel?: string;
  ollamaBase?: string;
  lmstudioModel?: string;
  lmstudioBase?: string;
  opencodeZenKey?: string;
  opencodeZenModel?: string;
  mapleApiKey?: string;
  mapleBase?: string;
  customApiBase?: string;
  customApiKey?: string;
  customModel?: string;
  editor: Editor;
  versionControl: VersionControl;
  installStacks: boolean;
  installBlossom: boolean;
  installLlmWiki: boolean;
  installNsyte: boolean;
  whitelistExtra?: string;   // space-separated extra npubs to whitelist (onboard)
  watchdogNpub?: string;
}

export interface Installed {
  rust: boolean;
  node: boolean;
  git: boolean;
  nak: boolean;
  relay: boolean;
  ngit: boolean;
  nvpn: boolean;
  claude: boolean;
  gh: boolean;
  stacks: boolean;
  blossom: boolean;
  nsyte: boolean;
}

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

// Local alias — keeps detectPlatform / detectInstalled call sites terse.
const has = hasBin;

export function detectPlatform(): Platform {
  const rawOs = process.platform;
  const rawArch = process.arch;

  const osName: OS = rawOs === 'darwin' ? 'macos' : 'linux';
  const arch: Arch = rawArch === 'arm64' ? 'aarch64' : 'x86_64';

  let pkgMgr: PkgMgr = 'brew';
  if (osName === 'linux') {
    if (has('apt-get'))  pkgMgr = 'apt';
    else if (has('dnf')) pkgMgr = 'dnf';
    else pkgMgr = 'pacman';
  }

  const serviceBackend: ServiceBackend = osName === 'macos' ? 'launchd' : 'systemd';
  const homeDir = os.homedir();

  // Upstream (mmalmi/nostr-vpn) publishes Rust-toolchain-style target triples.
  // Linux builds are statically linked against musl so they run on any distro
  // without glibc-version pins — there is NO `-gnu` asset, only `-musl`. An
  // earlier version of this map used `-gnu` and silently 404'd on every Linux
  // install. macOS x86_64 is unsupported upstream (no published asset); the
  // x86_64-apple-darwin entry is kept as a placeholder so the URL fails with
  // a clear message instead of an earlier undefined-template error.
  const nvpnTargetMap: Record<string, Record<string, string>> = {
    macos:  { aarch64: 'aarch64-apple-darwin',         x86_64: 'x86_64-apple-darwin' },
    linux:  { aarch64: 'aarch64-unknown-linux-musl',   x86_64: 'x86_64-unknown-linux-musl' },
  };
  const nvpnTarget = nvpnTargetMap[osName][arch];

  const platform: Platform = {
    os: osName,
    arch,
    pkgMgr,
    serviceBackend,
    nvpnTarget,
    homeDir,
    cargoBin: `${homeDir}/.cargo/bin`,
    logDir:     `${homeDir}/logs`,
    scriptsDir: `${homeDir}/scripts`,
    projectsDir:`${homeDir}/projects`,
    configDir:  `${homeDir}/.config/nostr-rs-relay`,
    relayDataDir: osName === 'macos'
      ? `${homeDir}/Library/Application Support/nostr-rs-relay`
      : `${homeDir}/.local/share/nostr-rs-relay`,
  };

  if (osName === 'macos') {
    platform.launchAgentsDir = `${homeDir}/Library/LaunchAgents`;
  }

  return platform;
}

export function detectInstalled(): Installed {
  return {
    rust:    has('rustc'),
    node:    has('node'),
    git:     has('git'),
    nak:     has('nak'),
    relay:   has('nostr-rs-relay'),
    ngit:    has('ngit'),
    nvpn:    has('nvpn'),
    claude:  has('claude'),
    gh:      has('gh'),
    stacks:  has('stacks'),
    blossom: fs.existsSync(`${os.homedir()}/blossom-server`),
    nsyte:   has('nsyte'),
  };
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
