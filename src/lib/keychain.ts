import { execSync } from 'child_process';
import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { atomicWriteJson } from './atomic-write.js';

// Static slots:
//   ai-api-key    — legacy single-provider AI key (pre-multi-provider)
//   watchdog-nsec — secret key for the in-Node watchdog heartbeat loop
//   seed-nsec     — secret key the seed CLI publishes test events with
// The dynamic ai:${string} slots are written by the per-provider AI
// config system (anthropic, openai, claude-code, …). Template literal
// preserves type-safety against typos — `ai-apikey` still fails to
// compile — while allowing the dynamic shape.
export type KeychainKey =
  | 'ai-api-key'
  | 'watchdog-nsec'
  | 'seed-nsec'
  | `ai:${string}`;

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
  private readonly storageDir: string;
  private readonly filePath:   string;
  // One-shot warning gate. Previously a corrupted secrets file or a
  // decipher failure silently looked like "key never stored," which
  // caused callers (legacy-chat.ts, ai-config.ts migration) to loop
  // re-prompting the user every request. We still return null so
  // those callers don't crash, but now a single loud stderr line
  // tells the user what's actually wrong and how to recover.
  private static corruptedWarned = false;

  constructor(storageDir?: string) {
    this.storageDir = storageDir
      ?? path.join(os.homedir(), '.config', 'nostr-station');
    this.filePath = path.join(this.storageDir, 'secrets');
  }

  backendName() {
    return `encrypted file (${this.filePath})`;
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

  private warnCorrupted(detail: string): void {
    if (EncryptedFileBackend.corruptedWarned) return;
    EncryptedFileBackend.corruptedWarned = true;
    process.stderr.write(
      `[keychain] WARNING: encrypted secrets file at ${this.filePath} ` +
      `appears unreadable (${detail}). Stored credentials cannot be ` +
      `decrypted. To recover: back up the file, remove it, and re-enter ` +
      `each credential when prompted. Most common cause is /etc/machine-id ` +
      `or $HOME changing (e.g. moving the file between machines). ` +
      `(Warning shown once per process.)\n`
    );
  }

  private readStore(): Record<string, { iv: string; tag: string; data: string }> {
    let raw: string;
    try { raw = fs.readFileSync(this.filePath, 'utf8'); }
    catch (e: any) {
      // ENOENT is the legitimate first-run case — empty store.
      if (e?.code === 'ENOENT') return {};
      this.warnCorrupted(`read failed: ${e?.message || e}`);
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.warnCorrupted('contents are not a JSON object');
        return {};
      }
      return parsed;
    } catch (e: any) {
      this.warnCorrupted(`JSON parse failed: ${e?.message || e}`);
      return {};
    }
  }

  private writeStore(store: Record<string, { iv: string; tag: string; data: string }>) {
    // atomicWriteJson handles mkdir-with-0o700 + tmp+rename + mode in
    // one place. A SIGKILL between read and write previously left the
    // file truncated; atomic rename guarantees either the prior or
    // the new contents, never a half-written file.
    atomicWriteJson(this.filePath, store, { mode: 0o600 });
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
    } catch (e: any) {
      // GCM auth-tag failure means the ciphertext, tag, or derived
      // key doesn't match. The entry is unrecoverable — surface
      // loudly so the user knows it's not just "credential missing."
      this.warnCorrupted(`decryption failed for "${key}": ${e?.message || e}`);
      return null;
    }
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

// Tests reset the cached instance between cases that toggle env vars.
export function _resetKeychainCache(): void {
  _instance = null;
}

export function getKeychainBackendName(): string {
  return getKeychain().backendName();
}

// All known credential keys — used by `keychain list`
export const ALL_KEYS: KeychainKey[] = ['ai-api-key', 'watchdog-nsec', 'seed-nsec'];
