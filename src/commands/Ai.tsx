/**
 * `nostr-station ai …` CLI — multi-provider AI configuration.
 *
 * Subcommands:
 *   ai list                           display configured providers + defaults
 *   ai add <provider>                 enable / set-up a provider (interactive key for API)
 *   ai remove <provider>              delete keychain entry + remove from config
 *   ai default terminal <provider>    set terminal-native default
 *   ai default chat <provider>        set chat (API) default
 *
 * Macos quirk: `ai add <api-provider>` stores the key via the OS keychain,
 * which on macOS requires the running process to be in the user's Aqua
 * session — i.e. launched from iTerm / Terminal.app, not from the
 * dashboard's node-pty terminal panel (which uses POSIX_SPAWN_SETSID and
 * loses the Aqua bootstrap). The CLI works from a real terminal; the
 * dashboard's Config panel's browser form is the canonical in-dashboard
 * path. See src/lib/terminal.ts for the underlying constraint.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { P } from '../onboard/components/palette.js';
import { Select } from '../onboard/components/Select.js';
import {
  PROVIDERS, getProvider, keychainAccountFor,
  type Provider, type ApiProvider,
} from '../lib/ai-providers.js';
import {
  readAiConfig, setProviderEntry, setDefault as setAiDefaultCfg,
  migrateIfNeeded,
} from '../lib/ai-config.js';
import { getKeychain } from '../lib/keychain.js';

// ── Shared helpers ─────────────────────────────────────────────────────────

function providerTypeBadge(p: Provider): string {
  return p.type === 'terminal-native' ? 'term' : 'api ';
}

async function isConfigured(id: string): Promise<boolean> {
  const cfg = readAiConfig();
  const entry = cfg.providers[id];
  if (!entry) return false;
  const p = getProvider(id);
  if (!p) return false;
  if (p.type === 'terminal-native') return !!entry.enabled;
  return !!entry.keyRef || !!(p as ApiProvider).bareKey;
}

// ── ai list ────────────────────────────────────────────────────────────────

const AiList: React.FC = () => {
  const [rows, setRows] = useState<Array<{ p: Provider; configured: boolean }> | null>(null);
  const [defs, setDefs] = useState<{ terminal?: string; chat?: string }>({});

  useEffect(() => {
    (async () => {
      // Trigger migration so a v0.x user running `ai list` for the first
      // time sees their Anthropic provider already ported. Cheap no-op
      // on second run.
      await migrateIfNeeded();

      const cfg = readAiConfig();
      const list = Object.values(PROVIDERS);
      const out = await Promise.all(
        list.map(async p => ({ p, configured: await isConfigured(p.id) })),
      );
      setRows(out);
      setDefs(cfg.defaults || {});
    })();
  }, []);

  if (!rows) return <Text color={P.muted}>loading…</Text>;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold color={undefined}>AI Providers</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map(({ p, configured }) => {
          const isTermDef = defs.terminal === p.id;
          const isChatDef = defs.chat === p.id;
          const state = configured
            ? (p.type === 'terminal-native' ? 'enabled' : 'configured')
            : 'not configured';
          const stateColor = configured ? P.success : P.muted;

          return (
            <Box key={p.id} flexDirection="row">
              <Box width={16}><Text color={undefined}>{p.id}</Text></Box>
              <Box width={6}><Text color={P.muted}>{providerTypeBadge(p)}</Text></Box>
              <Box width={18}><Text color={stateColor}>{state}</Text></Box>
              <Box>
                <Text color={P.accent}>
                  {isTermDef ? '★ terminal default' : ''}
                  {isTermDef && isChatDef ? '  ' : ''}
                  {isChatDef ? '★ chat default' : ''}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={P.muted}>defaults.terminal: <Text color={undefined}>{defs.terminal ?? '(none)'}</Text></Text>
        <Text color={P.muted}>defaults.chat:     <Text color={undefined}>{defs.chat     ?? '(none)'}</Text></Text>
      </Box>
    </Box>
  );
};

// ── ai add <provider> ──────────────────────────────────────────────────────

const AiAdd: React.FC<{ providerId: string }> = ({ providerId }) => {
  const [phase, setPhase] = useState<'resolving' | 'unknown' | 'key' | 'saving' | 'done' | 'error'>('resolving');
  const [input, setInput] = useState('');
  const [msg, setMsg]     = useState('');
  const [p, setP]         = useState<Provider | null>(null);

  useEffect(() => {
    const provider = getProvider(providerId);
    if (!provider) { setPhase('unknown'); return; }
    setP(provider);

    // Terminal-native: enable + maybe set as terminal default, no key prompt.
    if (provider.type === 'terminal-native') {
      setProviderEntry(provider.id, { enabled: true });
      const cfg = readAiConfig();
      if (!cfg.defaults.terminal) setAiDefaultCfg('terminal', provider.id);
      setMsg(`${provider.displayName} enabled. defaults.terminal = ${readAiConfig().defaults.terminal}`);
      setPhase('done');
      return;
    }

    // Bare-key local daemon: entry only, no key.
    if (provider.type === 'api' && provider.bareKey) {
      setProviderEntry(provider.id, {});  // presence = opted-in
      const cfg = readAiConfig();
      if (!cfg.defaults.chat) setAiDefaultCfg('chat', provider.id);
      setMsg(`${provider.displayName} added (local daemon — no key required). defaults.chat = ${readAiConfig().defaults.chat}`);
      setPhase('done');
      return;
    }

    // API provider needing a real key — prompt for it.
    setPhase('key');
  }, [providerId]);

  useEffect(() => {
    if (phase === 'done' || phase === 'unknown' || phase === 'error') {
      // Let Ink flush the screen before the process exits.
      setTimeout(() => process.exit(phase === 'unknown' ? 1 : 0), 100);
    }
  }, [phase]);

  if (phase === 'resolving') {
    return <Text color={P.muted}>resolving {providerId}…</Text>;
  }
  if (phase === 'unknown') {
    return <Text color={P.error}>Unknown provider: {providerId}. Try: nostr-station ai list</Text>;
  }
  if (phase === 'saving') {
    return <Text color={P.muted}>saving…</Text>;
  }
  if (phase === 'done') {
    return <Text color={P.success}>✓ {msg}</Text>;
  }
  if (phase === 'error') {
    return <Text color={P.error}>✗ {msg}</Text>;
  }

  // phase === 'key'
  const onSubmit = async () => {
    if (!input || !p) return;
    if (input.length < 4) { setMsg('key too short'); return; }
    setPhase('saving');
    try {
      await getKeychain().store(keychainAccountFor(p.id), input);
      setProviderEntry(p.id, { keyRef: `keychain:${keychainAccountFor(p.id)}` });
      const cfg = readAiConfig();
      if (!cfg.defaults.chat) setAiDefaultCfg('chat', p.id);
      setMsg(`${p.displayName} key stored. defaults.chat = ${readAiConfig().defaults.chat}`);
      setPhase('done');
    } catch (e: any) {
      const err = String(e?.message || e);
      // macOS specific hint when the keychain write fails from a
      // non-Aqua session (e.g. the dashboard's terminal tab).
      const mac = process.platform === 'darwin' && /exit code 36|User interaction is not allowed/.test(err);
      setMsg(mac
        ? `keychain write failed — macOS needs a real iTerm/Terminal.app session, not the dashboard terminal tab. Details: ${err.slice(0, 160)}`
        : `keychain write failed: ${err.slice(0, 200)}`
      );
      setPhase('error');
    }
  };

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={undefined}>Add <Text bold>{p?.displayName}</Text> ({p?.id})</Text>
      <Text color={P.muted}>Paste API key (input hidden):</Text>
      <Box marginTop={1}>
        <Text color={P.accent}>&gt; </Text>
        <TextInput value={input} onChange={setInput} onSubmit={onSubmit} mask="*" />
      </Box>
      {msg && <Text color={P.error}>{msg}</Text>}
    </Box>
  );
};

// ── ai remove <provider> ───────────────────────────────────────────────────

const AiRemove: React.FC<{ providerId: string; yes: boolean }> = ({ providerId, yes }) => {
  const [phase, setPhase] = useState<'resolving' | 'confirm' | 'removing' | 'done' | 'unknown' | 'notConfigured'>('resolving');
  const [msg, setMsg]     = useState('');
  const [p, setP]         = useState<Provider | null>(null);

  useEffect(() => {
    const provider = getProvider(providerId);
    if (!provider) { setPhase('unknown'); return; }
    setP(provider);
    (async () => {
      if (!(await isConfigured(providerId))) { setPhase('notConfigured'); return; }
      if (yes) { doRemove(provider); return; }
      setPhase('confirm');
    })();
  }, [providerId]);

  useEffect(() => {
    if (phase === 'done' || phase === 'unknown' || phase === 'notConfigured') {
      setTimeout(() => process.exit(phase === 'done' ? 0 : 1), 100);
    }
  }, [phase]);

  async function doRemove(provider: Provider) {
    setPhase('removing');
    try {
      if (provider.type === 'api') {
        try { await getKeychain().delete(keychainAccountFor(provider.id)); } catch {}
      }
      setProviderEntry(provider.id, null);
      // If this was a default, clear the default slot so the UI doesn't
      // point to a non-existent provider.
      const cfg = readAiConfig();
      if (cfg.defaults.terminal === provider.id) setAiDefaultCfg('terminal', null);
      if (cfg.defaults.chat     === provider.id) setAiDefaultCfg('chat',     null);
      setMsg(`${provider.displayName} removed`);
      setPhase('done');
    } catch (e: any) {
      setMsg(`remove failed: ${String(e?.message || e).slice(0, 200)}`);
      setPhase('done');  // still exit 0 — partial removes aren't worth a hard fail here
    }
  }

  if (phase === 'resolving') return <Text color={P.muted}>resolving…</Text>;
  if (phase === 'unknown')   return <Text color={P.error}>Unknown provider: {providerId}</Text>;
  if (phase === 'notConfigured') return <Text color={P.muted}>{providerId} is not configured.</Text>;
  if (phase === 'removing')  return <Text color={P.muted}>removing…</Text>;
  if (phase === 'done')      return <Text color={P.success}>✓ {msg}</Text>;

  return (
    <Select
      label={`Remove ${p?.displayName}? (deletes keychain entry + config)`}
      options={[
        { label: 'Yes, remove', value: 'yes' },
        { label: 'Cancel',      value: 'no'  },
      ]}
      onSelect={item => {
        if (item.value === 'yes' && p) doRemove(p);
        else process.exit(0);
      }}
    />
  );
};

// ── ai default terminal|chat <provider> ────────────────────────────────────

const AiDefault: React.FC<{ kind: 'terminal' | 'chat'; providerId: string }> = ({ kind, providerId }) => {
  const [msg, setMsg]     = useState('');
  const [color, setColor] = useState<string>(P.muted);

  useEffect(() => {
    const p = getProvider(providerId);
    if (!p) { setMsg(`Unknown provider: ${providerId}`); setColor(P.error); exit(1); return; }
    // Type-appropriateness check — setting an API provider as the terminal
    // default (or vice-versa) would silently produce a broken UI.
    if (kind === 'terminal' && p.type !== 'terminal-native') {
      setMsg(`${providerId} is not a terminal-native provider (it's ${p.type})`);
      setColor(P.error); exit(1); return;
    }
    if (kind === 'chat' && p.type !== 'api') {
      setMsg(`${providerId} is not an API provider (it's ${p.type})`);
      setColor(P.error); exit(1); return;
    }
    setAiDefaultCfg(kind, providerId);
    setMsg(`defaults.${kind} = ${providerId}`);
    setColor(P.success);
    exit(0);
  }, [kind, providerId]);

  function exit(code: number) { setTimeout(() => process.exit(code), 100); }

  return <Text color={color}>{msg || 'saving…'}</Text>;
};

// ── Root component ─────────────────────────────────────────────────────────

export type AiAction = 'list' | 'add' | 'remove' | 'default' | 'help';

interface AiProps {
  action:     AiAction;
  providerId?: string;
  // `default` subcommand takes both kind ('terminal' | 'chat') AND providerId.
  kind?:      'terminal' | 'chat';
  yes?:       boolean;
}

export const Ai: React.FC<AiProps> = ({ action, providerId, kind, yes }) => {
  switch (action) {
    case 'list':
      return <AiList />;
    case 'add':
      if (!providerId) return <Text color={P.error}>Usage: nostr-station ai add &lt;provider&gt;</Text>;
      return <AiAdd providerId={providerId} />;
    case 'remove':
      if (!providerId) return <Text color={P.error}>Usage: nostr-station ai remove &lt;provider&gt;</Text>;
      return <AiRemove providerId={providerId} yes={!!yes} />;
    case 'default':
      if (!kind || !providerId) return <Text color={P.error}>Usage: nostr-station ai default &lt;terminal|chat&gt; &lt;provider&gt;</Text>;
      return <AiDefault kind={kind} providerId={providerId} />;
    default:
      return <AiList />;
  }
};
