/**
 * AI provider registry — canonical list of every provider nostr-station
 * can talk to, split into two distinct surfaces:
 *
 *   - terminal-native: spawned as a PTY subprocess (Claude Code, OpenCode Go).
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
 *
 * ── Curated provider set ───────────────────────────────────────────────
 *
 * The list is intentionally small. Two terminal-native + four API
 * providers + a Custom escape hatch:
 *
 *   - Anthropic         — direct API for Claude. Best tool-use support.
 *   - OpenCode Zen      — Soapbox's Nostr-native paid tier (sats credits
 *                         tied to npub).
 *   - PayPerQ ⚡        — Lightning-paid relay for Claude/GPT.
 *   - Routstr ⚡        — Cashu-paid relay for Claude/GPT/Llama.
 *   - Custom            — user-supplied baseUrl + key, OpenAI-compat
 *                         shape. Escape hatch for anyone who wants
 *                         OpenAI / OpenRouter / Groq / Gemini / Ollama /
 *                         LM Studio / etc.
 *
 * Adding a "card" for every provider in existence dilutes the curated
 * Nostr-first feel of the dashboard and explodes the test surface for
 * the tool-use loop. Keep the registry focused; let Custom Provider
 * cover the long tail.
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
    displayName: 'OpenCode Go',
    type: 'terminal-native',
    binary: 'opencode',
  },

  // Anthropic-native — uses /v1/messages + x-api-key header. Best
  // tool-use support of any provider; the Chat pane's default.
  'anthropic': {
    id: 'anthropic',
    displayName: 'Anthropic',
    type: 'api',
    baseUrl: '',
    defaultModel: 'claude-opus-4-6',
    flavor: 'anthropic',
  },

  // Nostr-native paid tier — sats credits tied to the user's npub.
  'opencode-zen': {
    id: 'opencode-zen',
    displayName: 'OpenCode Zen',
    type: 'api',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'claude-opus-4-6',
    flavor: 'openai-compat',
  },

  // Lightning- and Cashu-paid relays. Same OpenAI-compat shape as the
  // commercial providers; keys are short-lived per-call invoices the
  // user funds out-of-band.
  'payperq': {
    id: 'payperq',
    displayName: 'PayPerQ ⚡',
    type: 'api',
    baseUrl: 'https://api.ppq.ai/v1',
    defaultModel: 'claude-sonnet-4',
    flavor: 'openai-compat',
  },
  'routstr': {
    id: 'routstr',
    displayName: 'Routstr ⚡',
    type: 'api',
    baseUrl: 'https://api.routstr.com/v1',
    defaultModel: 'claude-sonnet-4',
    flavor: 'openai-compat',
  },

  // Escape hatch — user supplies baseUrl + model + key, we treat the
  // endpoint as OpenAI-compat. Covers OpenAI / OpenRouter / Groq /
  // Mistral / Gemini / Ollama / LM Studio / Maple / anything else with
  // a /v1/chat/completions endpoint. The defaults below are placeholders
  // overridden by the per-provider config in ai-config.json.
  'custom': {
    id: 'custom',
    displayName: 'Custom Provider',
    type: 'api',
    baseUrl: '',
    defaultModel: '',
    flavor: 'openai-compat',
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
 *
 * Anything not in the curated registry maps to 'custom' — the migration
 * still preserves the baseUrl + key, just under the Custom Provider
 * entry instead of a removed dedicated entry.
 */
export function inferIdFromBaseUrl(baseUrl: string): string {
  const url = (baseUrl || '').toLowerCase();
  if (!url) return 'anthropic';
  // Order matters: more specific matches first.
  if (url.includes('opencode.ai'))  return 'opencode-zen';
  if (url.includes('routstr'))      return 'routstr';
  if (url.includes('ppq.ai'))       return 'payperq';
  // Everything else (openai/openrouter/groq/mistral/gemini/ollama/lmstudio
  // /maple/self-hosted) → Custom Provider. The user's existing baseUrl
  // and keychain entry survive intact under the 'custom' id.
  return 'custom';
}
