import { execSync } from 'child_process';
import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export type KeychainKey = 'ai-api-key' | 'watchdog-nsec' | 'demo-nsec';

export interface KeychainBackend {
  store(key: KeychainKey, value: string): Promise<void>;
  retrieve(key: KeychainKey): Promise<string | null>;
  delete(key: KeychainKey): Promise<void>;
  backendName(): string;
}

// ── macOS Keychain ─────────────────────────────────────────────────────────────
// Uses execa with array args — no shell interpolation, value never touches a shell

class MacOSKeychain implements KeychainBackend {
  backendName() { return 'macOS Keychain'; }

  async store(key: KeychainKey, value: string): Promise<void> {
    // `-U` updates in place if an entry already exists, but the in-place
    // path triggers a SecurityAgent GUI prompt the first time any process
    // that isn't in the user's Aqua session tries to use it. That fails
    // with exit code 36 ("User interaction is not allowed") under SSH or
    // inside the dashboard's node-pty terminal panel.
    //
    // Delete-then-add sidesteps the prompt: the fresh add is owned by the
    // caller process and needs no confirmation. The delete silently swallows
    // the not-found case so it's safe on first write.
    try {
      await execa('security', [
        'delete-generic-password', '-s', 'nostr-station', '-a', key,
      ]);
    } catch {}
    await execa('security', [
      'add-generic-password', '-s', 'nostr-station', '-a', key, '-w', value,
    ]);
  }

  async retrieve(key: KeychainKey): Promise<string | null> {
    try {
      const { stdout } = await execa('security', [
        'find-generic-password', '-s', 'nostr-station', '-a', key, '-w',
      ]);
      return stdout.trim() || null;
    } catch { return null; }
  }

  async delete(key: KeychainKey): Promise<void> {
    try {
      await execa('security', [
        'delete-generic-password', '-s', 'nostr-station', '-a', key,
      ]);
    } catch {}
  }
}

// ── Linux GNOME Keyring ────────────────────────────────────────────────────────
// Uses execa with array args — value passed via stdin, never touches a shell

class LinuxKeyring implements KeychainBackend {
  backendName() { return 'GNOME Keyring'; }

  async store(key: KeychainKey, value: string): Promise<void> {
    await execa('secret-tool', [
      'store', '--label', `nostr-station ${key}`,
      'service', 'nostr-station', 'key', key,
    ], { input: value });
  }

  async retrieve(key: KeychainKey): Promise<string | null> {
    try {
      const { stdout } = await execa('secret-tool', [
        'lookup', 'service', 'nostr-station', 'key', key,
      ]);
      return stdout.trim() || null;
    } catch { return null; }
  }

  async delete(key: KeychainKey): Promise<void> {
    try {
      await execa('secret-tool', [
        'clear', 'service', 'nostr-station', 'key', key,
      ]);
    } catch {}
  }
}

// ── Linux headless fallback — AES-256-GCM encrypted file ──────────────────────
// Machine-derived key: not as strong as a proper keychain, but far better
// than plaintext. User is told which backend is active during onboard.

class EncryptedFileBackend implements KeychainBackend {
  private readonly filePath = path.join(
    os.homedir(), '.config', 'nostr-station', 'secrets'
  );

  backendName() {
    return 'encrypted file (~/.config/nostr-station/secrets)';
  }

  private deriveKey(): Buffer {
    let machineId = '';
    try { machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch {}
    return crypto.scryptSync(
      machineId + os.homedir(),
      'nostr-station-salt-v1',
      32
    ) as Buffer;
  }

  private readStore(): Record<string, { iv: string; tag: string; data: string }> {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch { return {}; }
  }

  private writeStore(store: Record<string, { iv: string; tag: string; data: string }>) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  async store(key: KeychainKey, value: string): Promise<void> {
    const k = this.deriveKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const store = this.readStore();
    store[key] = {
      iv:   iv.toString('hex'),
      tag:  tag.toString('hex'),
      data: data.toString('hex'),
    };
    this.writeStore(store);
  }

  async retrieve(key: KeychainKey): Promise<string | null> {
    const entry = this.readStore()[key];
    if (!entry) return null;
    try {
      const k = this.deriveKey();
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm', k, Buffer.from(entry.iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch { return null; }
  }

  async delete(key: KeychainKey): Promise<void> {
    const store = this.readStore();
    delete store[key];
    this.writeStore(store);
  }
}

// ── Backend selection ──────────────────────────────────────────────────────────

function hasCommand(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function isGnomeKeyringAvailable(): boolean {
  return hasCommand('secret-tool') && !!process.env.DBUS_SESSION_BUS_ADDRESS;
}

let _instance: KeychainBackend | null = null;

export function getKeychain(): KeychainBackend {
  if (_instance) return _instance;
  if (process.platform === 'darwin') {
    _instance = new MacOSKeychain();
  } else if (isGnomeKeyringAvailable()) {
    _instance = new LinuxKeyring();
  } else {
    _instance = new EncryptedFileBackend();
  }
  return _instance;
}

export function getKeychainBackendName(): string {
  return getKeychain().backendName();
}

// All known credential keys — used by `keychain list`
export const ALL_KEYS: KeychainKey[] = ['ai-api-key', 'watchdog-nsec'];
