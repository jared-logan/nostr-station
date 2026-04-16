/**
 * ai-config.json — per-provider AI configuration.
 *
 * Structure:
 *   {
 *     "providers": {
 *       "<provider-id>": {
 *         "enabled":  true,                        // terminal-native only
 *         "keyRef":   "keychain:ai:<provider-id>", // api only — pointer, never the key itself
 *         "model":    "...",                       // optional override
 *         "baseUrl":  "..."                        // optional override (api only)
 *       }
 *     },
 *     "defaults": {
 *       "terminal": "claude-code",   // default for Projects "Open in AI"
 *       "chat":     "anthropic"      // default for Chat pane
 *     }
 *   }
 *
 * The JSON never contains raw API keys — only a `keyRef` pointer back into
 * the OS keychain under the `ai:<provider-id>` account name. This file is
 * safe to inspect, commit to a dotfiles repo, or share as a template.
 *
 * Migration: v0.x installs stored a single provider in ~/.claude_env (base
 * URL + model) plus a keychain slot named `ai-api-key`. On first read we
 * silently translate that into the new shape under whichever provider the
 * legacy base URL matches (or `anthropic` if empty). See migrateIfNeeded().
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { inferIdFromBaseUrl, keychainAccountFor, PROVIDERS } from './ai-providers.js';
import { getKeychain } from './keychain.js';

const CONFIG_DIR  = path.join(os.homedir(), '.nostr-station');
const CONFIG_FILE = path.join(CONFIG_DIR, 'ai-config.json');

export interface ProviderConfig {
  // Terminal-native providers: explicit opt-in flag.
  enabled?: boolean;
  // API providers: pointer to the keychain slot holding the raw key.
  // Format is always `keychain:ai:<provider-id>` for consistency; we
  // never read from a keyRef pointing anywhere else. The field exists
  // at all so future backends (e.g. vault:// URIs) can slot in without
  // a schema change.
  keyRef?: string;
  // Optional overrides. When absent, PROVIDERS registry defaults apply.
  model?:   string;
  baseUrl?: string;
}

export interface AiConfig {
  providers: Record<string, ProviderConfig>;
  defaults: {
    terminal?: string;
    chat?:    string;
  };
}

/** Fresh config value — callers never share references across read/write. */
function emptyConfig(): AiConfig {
  return { providers: {}, defaults: {} };
}

function ensureDir(): void {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 }); } catch {}
}

function parseFile(): AiConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Defensive: accept partial shapes, fill in missing fields.
    return {
      providers: (parsed && typeof parsed.providers === 'object' && parsed.providers) || {},
      defaults:  (parsed && typeof parsed.defaults  === 'object' && parsed.defaults)  || {},
    };
  } catch {
    return null;
  }
}

export function readAiConfig(): AiConfig {
  const parsed = parseFile();
  return parsed ?? emptyConfig();
}

/**
 * Atomic write — we stage to a temp file in the same directory so an
 * interrupted write doesn't leave a half-parsed JSON that the next read
 * interprets as "no config" and re-migrates.
 */
export function writeAiConfig(cfg: AiConfig): void {
  ensureDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, CONFIG_FILE);
}

/**
 * Mutate helpers — useful for the CLI `ai` subcommands and the Config
 * panel's POST handlers. Always round-trip through readAiConfig() so we
 * pick up changes someone else made between invocations.
 */
export function setProviderEntry(id: string, entry: ProviderConfig | null): AiConfig {
  const cfg = readAiConfig();
  if (entry === null) delete cfg.providers[id];
  else                 cfg.providers[id] = { ...cfg.providers[id], ...entry };
  writeAiConfig(cfg);
  return cfg;
}

export function setDefault(kind: 'terminal' | 'chat', providerId: string | null): AiConfig {
  const cfg = readAiConfig();
  if (providerId === null) delete cfg.defaults[kind];
  else                      cfg.defaults[kind] = providerId;
  writeAiConfig(cfg);
  return cfg;
}

/**
 * One-shot migration from the v0.x single-provider layout.
 *
 * Source of truth for legacy state:
 *   - ~/.claude_env → ANTHROPIC_BASE_URL + CLAUDE_MODEL
 *   - keychain slot `ai-api-key` → the raw key
 *
 * We infer the provider-id from the base URL (empty = anthropic), copy
 * the key into the new slot `ai:<id>`, and write the new ai-config.json
 * with that provider as defaults.chat. We intentionally do NOT delete the
 * old `ai-api-key` slot — if a user rolls back to an older nostr-station
 * release, they'd otherwise lose their key. The old slot is small and
 * inert; they can purge it manually when they're confident on the new
 * version.
 *
 * Also auto-adds `claude-code` as a terminal-native provider when the
 * `claude` binary is on PATH — most users installed it via onboard, so
 * a fresh migration lands in the "expected" two-surface state (Chat =
 * Anthropic API, Terminal = Claude Code). Absence is fine; they can add
 * it later via Config panel or `nostr-station ai add claude-code`.
 *
 * Returns { migrated: true } when we wrote a new file, false when
 * ai-config.json already existed and we left it alone.
 */
export async function migrateIfNeeded(): Promise<{
  migrated: boolean;
  from?: { provider: string; model?: string };
  terminalEnabled?: string[];
}> {
  // 1. If an ai-config.json already exists, do nothing — even an empty
  //    file counts as "user has taken ownership of this state".
  if (fs.existsSync(CONFIG_FILE)) return { migrated: false };

  // 2. Build up what the migration will write. Anything we can't figure
  //    out just leaves the config empty (the "not configured" state that
  //    the Chat pane / Projects panel handle with a callout).
  const cfg = emptyConfig();
  let from: { provider: string; model?: string } | undefined;

  // 3. Legacy Anthropic-compatible config from ~/.claude_env.
  const envPath = path.join(os.homedir(), '.claude_env');
  let legacyBaseUrl = '';
  let legacyModel   = '';
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    legacyBaseUrl = content.match(/^export ANTHROPIC_BASE_URL="([^"]+)"/m)?.[1] ?? '';
    legacyModel   = content.match(/^export CLAUDE_MODEL="([^"]+)"/m)?.[1]      ?? '';
  } catch {
    // ~/.claude_env missing — means the user hasn't configured any API
    // provider yet. Still continue through the rest of the migration
    // (terminal-native detection below) so `claude-code` can be enabled
    // if it's on PATH.
  }

  const providerId = inferIdFromBaseUrl(legacyBaseUrl);

  // 4. Transfer the legacy keychain slot if present. The presence of a
  //    key is what distinguishes "user had Anthropic configured" from
  //    "user had only ~/.claude_env template lying around unused". Local
  //    bareKey sentinels (ollama / lm-studio / maple) count as configured
  //    even though they aren't real keys.
  let legacyKey: string | null = null;
  try {
    // getKeychain() returns one of three backends (macOS / secret-tool /
    // encrypted file). All three expose `retrieve(key)` returning the raw
    // string or null. Wrap in try to handle the encrypted-file case where
    // the old slot is just missing on a fresh install.
    legacyKey = await getKeychain().retrieve('ai-api-key');
  } catch {
    legacyKey = null;
  }

  if (legacyKey && PROVIDERS[providerId]) {
    // Copy into new per-provider slot. Keep the old slot intact — see
    // function docstring for the rollback-safety rationale.
    try {
      await getKeychain().store(keychainAccountFor(providerId), legacyKey);
    } catch {
      // Keychain write failed (common on macOS PTY-spawned contexts).
      // Fall through — the config migration still happens; the user will
      // hit "not configured" on first load and can re-enter the key via
      // Config panel (which runs in the web-server process, has Aqua).
    }

    cfg.providers[providerId] = {
      keyRef: `keychain:${keychainAccountFor(providerId)}`,
    };
    // Preserve whatever model the user was running on. Even if it matches
    // the registry default, an explicit entry documents intent — the next
    // round of migration edits can cleanup. Keep it simple.
    if (legacyModel) cfg.providers[providerId].model = legacyModel;
    cfg.defaults.chat = providerId;
    from = { provider: providerId, model: legacyModel || undefined };
  }

  // 5. Terminal-native auto-detection. If the `claude` binary is on PATH
  //    we know Claude Code is installed (probably via onboard) and enable
  //    it as the terminal default. `opencode` gets the same treatment.
  const terminalEnabled: string[] = [];
  const probe = (binary: string, id: string) => {
    try {
      execFileSync('which', [binary], { stdio: 'pipe' });
      cfg.providers[id] = { ...(cfg.providers[id] || {}), enabled: true };
      terminalEnabled.push(id);
    } catch {
      // Not installed — leave it out of the config so the UI renders a
      // "Set up a terminal AI in Config" callout rather than a broken
      // button pointing at a missing binary.
    }
  };
  probe('claude',   'claude-code');
  probe('opencode', 'opencode');

  if (terminalEnabled.length > 0 && !cfg.defaults.terminal) {
    // Prefer claude-code as the terminal default when both are present —
    // aligns with the opinionated "Claude Code + Anthropic" default
    // nostr-station has shipped since v0.x.
    cfg.defaults.terminal = terminalEnabled.includes('claude-code')
      ? 'claude-code'
      : terminalEnabled[0];
  }

  // 6. Commit — even an empty-ish cfg (no providers detected at all) still
  //    gets written so subsequent boots skip the migration probe.
  writeAiConfig(cfg);
  return { migrated: true, from, terminalEnabled };
}
