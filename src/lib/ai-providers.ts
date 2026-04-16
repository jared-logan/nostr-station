/**
 * AI provider registry — canonical list of every provider nostr-station
 * can talk to, split into two distinct surfaces:
 *
 *   - terminal-native: spawned as a PTY subprocess (Claude Code, OpenCode).
 *     cwd-scoped to the active project. No API key needed — the tool owns
 *     its own auth. Lives behind the dashboard's terminal panel.
 *
 *   - api: OpenAI-compat or Anthropic-native HTTP APIs, proxied from the
 *     Chat pane via /api/ai/chat. Needs a key stored in the OS keychain.
 *
 * Keep the two surfaces separate — a user's default for "Open in AI" can
 * be a terminal-native provider while the Chat pane uses a different API
 * provider. Never try to render an API provider as a terminal tab, or
 * spawn a terminal-native provider as a proxy — they're different beasts.
 *
 * This registry is STATIC. What's in ~/.config/nostr-station/ai-config.json
 * is which of these the user has configured + any per-provider overrides
 * (custom baseUrl, default model, etc.) — see src/lib/ai-config.ts.
 */

export type ProviderType = 'terminal-native' | 'api';

interface ProviderBase {
  id:          string;
  displayName: string;
  type:        ProviderType;
}

/**
 * Terminal-native provider — a binary we spawn in a PTY tab with the
 * project path as cwd. The tool handles its own auth (Claude Code logs
 * in via the `claude` CLI; OpenCode via its own setup flow). The dashboard
 * doesn't need an API key.
 */
export interface TerminalProvider extends ProviderBase {
  type:   'terminal-native';
  // Binary name we pass to node-pty / terminal.ts resolveCmd.
  binary: string;
}

/**
 * API provider — proxied HTTP endpoint. `flavor` picks which wire format
 * the proxy uses — Anthropic-native (x-api-key + /v1/messages) vs.
 * OpenAI-compat (Bearer + /v1/chat/completions).
 */
export interface ApiProvider extends ProviderBase {
  type:         'api';
  // Empty for Anthropic-native (always api.anthropic.com). Required for
  // any OpenAI-compat endpoint. A user-supplied baseUrl override in
  // ai-config.json wins over this default.
  baseUrl:      string;
  defaultModel: string;
  flavor:       'anthropic' | 'openai-compat';
  // Some providers don't need a real key (local daemons). Stash a
  // sentinel value so the Chat pane's "configured?" check passes and
  // we skip sending the Authorization header. Must match the values
  // web-server.ts already sniffs in streamOpenAICompat.
  bareKey?:     string;
}

export type Provider = TerminalProvider | ApiProvider;

/**
 * Master list. Keep the IDs stable — they're used as keychain account
 * names (`ai:<id>`), ai-config.json keys, and CLI args.
 *
 * Adding a provider: pick an ID, add an entry, done. The Chat pane and
 * Config panel enumerate this registry at runtime.
 */
export const PROVIDERS: Record<string, Provider> = {
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    type: 'terminal-native',
    binary: 'claude',
  },
  'opencode': {
    id: 'opencode',
    displayName: 'OpenCode',
    type: 'terminal-native',
    binary: 'opencode',
  },

  // Anthropic-native — uses /v1/messages + x-api-key header.
  'anthropic': {
    id: 'anthropic',
    displayName: 'Anthropic',
    type: 'api',
    baseUrl: '',
    defaultModel: 'claude-opus-4-6',
    flavor: 'anthropic',
  },

  // OpenAI + compat endpoints (GPT-4, OpenRouter, Groq, Mistral, Gemini…).
  'openai': {
    id: 'openai',
    displayName: 'OpenAI',
    type: 'api',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    flavor: 'openai-compat',
  },
  'openrouter': {
    id: 'openrouter',
    displayName: 'OpenRouter',
    type: 'api',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    flavor: 'openai-compat',
  },
  'opencode-zen': {
    id: 'opencode-zen',
    displayName: 'OpenCode Zen',
    type: 'api',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'claude-opus-4-6',
    flavor: 'openai-compat',
  },
  'groq': {
    id: 'groq',
    displayName: 'Groq',
    type: 'api',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    flavor: 'openai-compat',
  },
  'mistral': {
    id: 'mistral',
    displayName: 'Mistral',
    type: 'api',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    flavor: 'openai-compat',
  },
  'gemini': {
    id: 'gemini',
    displayName: 'Google Gemini',
    type: 'api',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    flavor: 'openai-compat',
  },

  // Cashu / sats / ecash-based Nostr-native providers.
  'routstr': {
    id: 'routstr',
    displayName: 'Routstr ⚡',
    type: 'api',
    baseUrl: 'https://api.routstr.com/v1',
    defaultModel: 'claude-sonnet-4',
    flavor: 'openai-compat',
  },
  'payperq': {
    id: 'payperq',
    displayName: 'PayPerQ ⚡',
    type: 'api',
    baseUrl: 'https://api.ppq.ai/v1',
    defaultModel: 'claude-sonnet-4',
    flavor: 'openai-compat',
  },

  // Local daemons. bareKey avoids the "configured?" check blocking chat
  // when no real key is needed.
  'ollama': {
    id: 'ollama',
    displayName: 'Ollama',
    type: 'api',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    flavor: 'openai-compat',
    bareKey: 'ollama',
  },
  'lmstudio': {
    id: 'lmstudio',
    displayName: 'LM Studio',
    type: 'api',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'default',
    flavor: 'openai-compat',
    bareKey: 'lm-studio',
  },
  'maple': {
    id: 'maple',
    displayName: 'Maple',
    type: 'api',
    baseUrl: 'http://localhost:8081/v1',
    defaultModel: 'claude-sonnet-4',
    flavor: 'openai-compat',
    bareKey: 'maple-desktop-auto',
  },
};

export function getProvider(id: string): Provider | null {
  return PROVIDERS[id] ?? null;
}

export function listProviders(): Provider[] {
  return Object.values(PROVIDERS);
}

export function listTerminalNative(): TerminalProvider[] {
  return listProviders().filter((p): p is TerminalProvider => p.type === 'terminal-native');
}

export function listApi(): ApiProvider[] {
  return listProviders().filter((p): p is ApiProvider => p.type === 'api');
}

/**
 * Keychain account name for an API provider's stored key.
 * Format: `ai:<provider-id>`. Paired with the existing service name
 * `nostr-station` in src/lib/keychain.ts.
 */
export function keychainAccountFor(providerId: string): `ai:${string}` {
  return `ai:${providerId}`;
}

/**
 * Best-effort inference of a provider-id from a legacy base URL
 * (the single-provider world stored base URL in ~/.claude_env). Used
 * only by the one-shot migration in ai-config.ts — new code should
 * always carry an explicit providerId instead.
 *
 * Empty baseUrl → 'anthropic' (the Anthropic-native default).
 */
export function inferIdFromBaseUrl(baseUrl: string): string {
  const url = (baseUrl || '').toLowerCase();
  if (!url) return 'anthropic';
  // Order matters: more specific matches first (opencode.ai/zen before
  // a hypothetical opencode.ai match; routstr and ppq before generic).
  if (url.includes('openrouter'))   return 'openrouter';
  if (url.includes('opencode.ai'))  return 'opencode-zen';
  if (url.includes('routstr'))      return 'routstr';
  if (url.includes('ppq.ai'))       return 'payperq';
  if (url.includes(':8081'))        return 'maple';
  if (url.includes(':11434'))       return 'ollama';
  if (url.includes(':1234'))        return 'lmstudio';
  if (url.includes('api.groq.com')) return 'groq';
  if (url.includes('mistral.ai'))   return 'mistral';
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('api.openai.com')) return 'openai';
  return 'custom';
}
