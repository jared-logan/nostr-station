import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

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
  installStacks: boolean;
  installBlossom: boolean;
  installLlmWiki: boolean;
  watchdogNsec?: string;
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
  stacks: boolean;
  blossom: boolean;
}

function cmd(c: string): string | null {
  try { return execSync(c, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

function has(bin: string): boolean {
  return cmd(`command -v ${bin}`) !== null;
}

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

  const nvpnTargetMap: Record<string, Record<string, string>> = {
    macos:  { aarch64: 'aarch64-apple-darwin',       x86_64: 'x86_64-apple-darwin' },
    linux:  { aarch64: 'aarch64-unknown-linux-gnu',   x86_64: 'x86_64-unknown-linux-gnu' },
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
    stacks:  has('stacks'),
    blossom: fs.existsSync(`${os.homedir()}/blossom-server`),
  };
}

export function npubToHex(npub: string): string {
  if (!has('nak')) return '';
  return cmd(`nak decode ${npub}`) ?? '';
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
