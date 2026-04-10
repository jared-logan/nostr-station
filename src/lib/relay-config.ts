import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

export interface RelaySettings {
  name: string;
  url: string;
  auth: boolean;
  dmAuth: boolean;
  whitelist: string[];   // hex pubkeys as stored in config
  dataDir: string;
  configPath: string;
}

export function defaultConfigPath(): string {
  return `${os.homedir()}/.config/nostr-rs-relay/config.toml`;
}

function cmd(c: string): string | null {
  try { return execSync(c, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

export function npubToHex(npub: string): string {
  if (!npub.startsWith('npub')) return npub;  // already hex or empty
  return cmd(`nak decode ${npub}`) ?? '';
}

export function hexToNpub(hex: string): string {
  if (hex.startsWith('npub')) return hex;  // already npub
  return cmd(`nak encode npub ${hex}`) ?? hex;
}

// ── Read ───────────────────────────────────────────────────────────────────────

export function readRelaySettings(configPath = defaultConfigPath()): RelaySettings | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');

    const name    = raw.match(/^name\s*=\s*"(.*)"/m)?.[1] ?? 'nostr-dev-relay';
    const port    = raw.match(/^port\s*=\s*(\d+)/m)?.[1] ?? '8080';
    const auth    = raw.match(/^nip42_auth\s*=\s*(true|false)/m)?.[1] !== 'false';
    const dmAuth  = raw.match(/^nip42_dms\s*=\s*(true|false)/m)?.[1] !== 'false';
    const dataDir = raw.match(/^data_directory\s*=\s*"(.*)"/m)?.[1] ?? '';

    // pubkey_whitelist = ["hex1", "hex2"] — inline array on one line
    const wlMatch = raw.match(/^pubkey_whitelist\s*=\s*\[([^\]]*)\]/m);
    const whitelist: string[] = [];
    if (wlMatch?.[1]) {
      const entries = wlMatch[1].match(/"([a-f0-9]{64})"/g) ?? [];
      for (const e of entries) whitelist.push(e.replace(/"/g, ''));
    }

    return { name, url: `ws://localhost:${port}`, auth, dmAuth, whitelist, dataDir, configPath };
  } catch { return null; }
}

// ── Whitelist ──────────────────────────────────────────────────────────────────

export function addToWhitelist(
  npubOrHex: string,
  configPath = defaultConfigPath(),
): { ok: boolean; hex: string; already: boolean } {
  const hex = npubToHex(npubOrHex);
  if (!hex || hex.length !== 64) return { ok: false, hex: npubOrHex, already: false };

  const settings = readRelaySettings(configPath);
  if (!settings) return { ok: false, hex, already: false };

  if (settings.whitelist.includes(hex)) return { ok: true, hex, already: true };

  return { ok: writeWhitelistHex([...settings.whitelist, hex], configPath), hex, already: false };
}

export function removeFromWhitelist(
  npubOrHex: string,
  configPath = defaultConfigPath(),
): { ok: boolean; hex: string } {
  const hex = npubToHex(npubOrHex);
  if (!hex) return { ok: false, hex: npubOrHex };

  const settings = readRelaySettings(configPath);
  if (!settings) return { ok: false, hex };

  const filtered = settings.whitelist.filter(h => h !== hex);
  return { ok: writeWhitelistHex(filtered, configPath), hex };
}

function writeWhitelistHex(hexList: string[], configPath: string): boolean {
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    const serialized = `pubkey_whitelist = [${hexList.map(h => `"${h}"`).join(', ')}]`;

    if (/^pubkey_whitelist\s*=/m.test(raw)) {
      // Replace the existing line (we always write as a single inline array)
      raw = raw.replace(/^pubkey_whitelist\s*=.*$/m, serialized);
    } else {
      // Insert after nip42_dms line
      raw = raw.replace(
        /(nip42_dms\s*=\s*(true|false))/,
        `$1\n${serialized}`,
      );
    }

    fs.writeFileSync(configPath, raw);
    return true;
  } catch { return false; }
}

// ── Auth flags ─────────────────────────────────────────────────────────────────

export function setAuthFlag(
  flag: 'nip42_auth' | 'nip42_dms',
  value: boolean,
  configPath = defaultConfigPath(),
): boolean {
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    raw = raw.replace(
      new RegExp(`^${flag}\\s*=\\s*(true|false)`, 'm'),
      `${flag} = ${value}`,
    );
    fs.writeFileSync(configPath, raw);
    return true;
  } catch { return false; }
}
