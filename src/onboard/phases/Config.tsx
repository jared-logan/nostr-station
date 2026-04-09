import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader } from '../components/Step.js';
import { Prompt } from '../components/Prompt.js';
import { Select, type SelectOption } from '../components/Select.js';
import { P } from '../components/palette.js';
import type { Config } from '../../lib/detect.js';
import { probeOllama, probeLmStudio } from '../../lib/detect.js';

interface ConfigPhaseProps {
  onDone: (config: Config) => void;
}

type Field =
  | 'npub' | 'bunker' | 'relayName' | 'fallbackRelays'
  | 'aiProvider'
  | 'openrouterKey' | 'openrouterModel'
  | 'routstrCashuToken' | 'routstrServer'
  | 'ppqApiKey'
  | 'opencodeZenKey' | 'opencodeZenModel'
  | 'mapleApiKey' | 'mapleBase'
  | 'ollamaModel' | 'ollamaBase'
  | 'lmstudioModel' | 'lmstudioBase'
  | 'customApiBase' | 'customApiKey' | 'customModel'
  | 'opencodeZenCustomModel'
  | 'editor'
  | 'installStacks' | 'installBlossom' | 'installLlmWiki';

const AI_PROVIDERS: SelectOption[] = [
  { label: 'Anthropic (Claude)          standard API key',        value: 'anthropic'     },
  { label: 'OpenRouter                  multi-model API',          value: 'openrouter'    },
  { label: 'OpenCode Zen                curated coding models',    value: 'opencode-zen'  },
  { label: 'Routstr  ⚡                 Lightning / Cashu',       value: 'routstr'       },
  { label: 'PayPerQ  ⚡                 pay-per-query',           value: 'ppq'           },
  { label: 'Ollama                      local models, no key',    value: 'ollama'        },
  { label: 'LM Studio                   local models, no key',    value: 'lmstudio'     },
  { label: 'Maple Proxy  🔒             TEE-encrypted, private',  value: 'maple'         },
  { label: 'Custom endpoint             any OpenAI-compat API',   value: 'custom'        },
];

const EDITORS: SelectOption[] = [
  { label: 'Claude Code',  value: 'claude-code' },
  { label: 'Cursor',       value: 'cursor'      },
  { label: 'Windsurf',     value: 'windsurf'    },
  { label: 'Copilot',      value: 'copilot'     },
  { label: 'Aider',        value: 'aider'       },
  { label: 'Codex',        value: 'codex'       },
  { label: 'Other / none', value: 'other'       },
];

const YES_NO: SelectOption[] = [
  { label: 'Yes', value: 'true'  },
  { label: 'No',  value: 'false' },
];

export const ConfigPhase: React.FC<ConfigPhaseProps> = ({ onDone }) => {
  const [field, setField] = useState<Field>('npub');
  const [values, setValues] = useState<Partial<Record<Field, string>>>({
    relayName:     'nostr-dev-relay',
    fallbackRelays:'wss://relay.damus.io wss://nos.lol',
    routstrServer: 'https://api.routstr.com',
    ollamaBase:    'http://localhost:11434',
    lmstudioBase:  'http://localhost:1234',
  });
  const [input, setInput] = useState('');

  // Detected local models
  const [ollamaModels, setOllamaModels]     = useState<string[] | null>(null);
  const [lmstudioModels, setLmstudioModels] = useState<string[] | null>(null);
  const [probing, setProbing]               = useState(false);

  const set = (f: Field, v: string) => {
    setValues(prev => ({ ...prev, [f]: v }));
    setInput('');
  };

  const advance = (next: Field) => setField(next);

  // Probe local servers when provider is selected
  useEffect(() => {
    if (field !== 'ollamaModel' && field !== 'lmstudioModel') return;
    setProbing(true);
    if (field === 'ollamaModel') {
      probeOllama(values.ollamaBase).then(models => {
        setOllamaModels(models);
        setProbing(false);
      });
    } else {
      probeLmStudio(values.lmstudioBase).then(models => {
        setLmstudioModels(models);
        setProbing(false);
      });
    }
  }, [field]);

  const done = (config: Partial<Record<Field, string>>) => {
    onDone({
      npub:              config.npub ?? '',
      hexPubkey:         '',
      bunker:            config.bunker ?? '',
      relayName:         config.relayName ?? 'nostr-dev-relay',
      fallbackRelays:    config.fallbackRelays ?? 'wss://relay.damus.io',
      aiProvider:        (config.aiProvider as Config['aiProvider']) ?? 'anthropic',
      openrouterKey:     config.openrouterKey,
      openrouterModel:   config.openrouterModel,
      routstrCashuToken: config.routstrCashuToken,
      routstrServer:     config.routstrServer,
      ppqApiKey:         config.ppqApiKey,
      opencodeZenKey:    config.opencodeZenKey,
      opencodeZenModel:  config.opencodeZenModel,
      mapleApiKey:       config.mapleApiKey,
      mapleBase:         config.mapleBase,
      ollamaModel:       config.ollamaModel,
      ollamaBase:        config.ollamaBase,
      lmstudioModel:     config.lmstudioModel,
      lmstudioBase:      config.lmstudioBase,
      customApiBase:     config.customApiBase,
      customApiKey:      config.customApiKey,
      customModel:       config.customModel,
      editor:            (config.editor as Config['editor']) ?? 'claude-code',
      installStacks:     config.installStacks !== 'false',
      installBlossom:    config.installBlossom === 'true',
      installLlmWiki:    config.installLlmWiki !== 'false',
    });
  };

  const Confirmed = ({ label, value }: { label: string; value: string }) => (
    <Box>
      <Text color={P.success}>  ✓ </Text>
      <Text color={P.muted}>{label}  </Text>
      <Text>{value || '(skipped)'}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <PhaseHeader number={2} title="Configuration" />

      {/* Confirmed fields */}
      {values.npub           !== undefined && field !== 'npub'           && <Confirmed label="npub"            value={values.npub!} />}
      {values.bunker         !== undefined && field !== 'bunker'         && <Confirmed label="bunker"          value={values.bunker ? '••••••••' : '(later)'} />}
      {values.relayName      !== undefined && field !== 'relayName'      && <Confirmed label="relay name"      value={values.relayName!} />}
      {values.fallbackRelays !== undefined && field !== 'fallbackRelays' && <Confirmed label="fallback relays" value={values.fallbackRelays!} />}
      {values.aiProvider     !== undefined && field !== 'aiProvider'     && <Confirmed label="AI provider"     value={values.aiProvider!} />}
      {values.editor         !== undefined && field !== 'editor'         && <Confirmed label="AI coding tool"  value={values.editor!} />}

      {/* npub */}
      {field === 'npub' && (
        <Prompt label="Your npub" placeholder="npub1..." value={input}
          onChange={setInput}
          onSubmit={v => { set('npub', v); advance('bunker'); }} />
      )}

      {/* bunker */}
      {field === 'bunker' && (
        <Prompt label="Amber bunker string (blank = configure later)" placeholder="bunker://..."
          value={input} onChange={setInput}
          onSubmit={v => { set('bunker', v); advance('relayName'); }} />
      )}

      {/* relay name */}
      {field === 'relayName' && (
        <Prompt label="Relay name" placeholder="nostr-dev-relay" value={input}
          onChange={setInput}
          onSubmit={v => { set('relayName', v || 'nostr-dev-relay'); advance('fallbackRelays'); }} />
      )}

      {/* fallback relays */}
      {field === 'fallbackRelays' && (
        <Prompt label="Fallback relay URLs (space-separated)" placeholder="wss://relay.damus.io wss://nos.lol"
          value={input} onChange={setInput}
          onSubmit={v => { set('fallbackRelays', v || 'wss://relay.damus.io wss://nos.lol'); advance('aiProvider'); }} />
      )}

      {/* AI provider selection */}
      {field === 'aiProvider' && (
        <Select
          label="AI provider for Claude Code"
          options={AI_PROVIDERS}
          onSelect={item => {
            set('aiProvider', item.value);
            if      (item.value === 'openrouter')   advance('openrouterKey');
            else if (item.value === 'opencode-zen') advance('opencodeZenKey');
            else if (item.value === 'routstr')      advance('routstrCashuToken');
            else if (item.value === 'ppq')          advance('ppqApiKey');
            else if (item.value === 'ollama')       advance('ollamaModel');
            else if (item.value === 'lmstudio')     advance('lmstudioModel');
            else if (item.value === 'maple')        advance('mapleApiKey');
            else if (item.value === 'custom')       advance('customApiBase');
            else advance('editor');  // anthropic — no extra fields needed
          }}
        />
      )}

      {/* OpenRouter */}
      {field === 'openrouterKey' && (
        <Prompt label="OpenRouter API key" value={input} onChange={setInput}
          onSubmit={v => { set('openrouterKey', v); advance('openrouterModel'); }} mask />
      )}
      {field === 'openrouterModel' && (
        <Prompt label="Model" placeholder="anthropic/claude-sonnet-4" value={input}
          onChange={setInput}
          onSubmit={v => { set('openrouterModel', v || 'anthropic/claude-sonnet-4'); advance('editor'); }} />
      )}

      {/* Routstr — Lightning/Cashu */}
      {field === 'routstrCashuToken' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Mint a Cashu token (≥3000 sats) at </Text>
            <Text color={P.accentBright}>cashu.me</Text>
            <Text color={P.muted}>, then paste it below.</Text>
          </Box>
          <Prompt label="Cashu token" placeholder="cashuA..." value={input}
            onChange={setInput}
            onSubmit={v => { set('routstrCashuToken', v); advance('routstrServer'); }} mask />
        </Box>
      )}
      {field === 'routstrServer' && (
        <Prompt label="Routstr server URL" placeholder="https://api.routstr.com" value={input}
          onChange={setInput}
          onSubmit={v => { set('routstrServer', v || 'https://api.routstr.com'); advance('editor'); }} />
      )}

      {/* PayPerQ */}
      {field === 'ppqApiKey' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Get an API key at </Text>
            <Text color={P.accentBright}>ppq.ai</Text>
          </Box>
          <Prompt label="PPQ API key" value={input} onChange={setInput}
            onSubmit={v => { set('ppqApiKey', v); advance('editor'); }} mask />
        </Box>
      )}

      {/* OpenCode Zen — curated coding models */}
      {field === 'opencodeZenKey' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Curated models benchmarked for coding agents. Get key at </Text>
            <Text color={P.accentBright}>opencode.ai/auth</Text>
          </Box>
          <Prompt label="OpenCode Zen API key" value={input} onChange={setInput}
            onSubmit={v => { set('opencodeZenKey', v); advance('opencodeZenModel'); }} mask />
        </Box>
      )}
      {field === 'opencodeZenModel' && (
        <Select
          label="Model (opencode.ai/zen)"
          options={[
            { label: 'opencode/claude-opus-4-6     (recommended)', value: 'opencode/claude-opus-4-6' },
            { label: 'opencode/gpt-5.4',                           value: 'opencode/gpt-5.4' },
            { label: 'opencode/gemini-3-pro',                      value: 'opencode/gemini-3-pro' },
            { label: 'opencode/big-pickle',                        value: 'opencode/big-pickle' },
            { label: 'Type a custom model ID →',                   value: '__custom__' },
          ]}
          onSelect={item => {
            if (item.value === '__custom__') { advance('opencodeZenCustomModel'); return; }
            set('opencodeZenModel', item.value);
            advance('editor');
          }}
        />
      )}

      {field === 'opencodeZenCustomModel' && (
        <Prompt label="Custom model ID" placeholder="opencode/my-model" value={input}
          onChange={setInput}
          onSubmit={v => { set('opencodeZenModel', v); advance('editor'); }} />
      )}

      {/* Maple Proxy — TEE-encrypted private inference */}
      {field === 'mapleApiKey' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>{'🔒 End-to-end encrypted inference via Trusted Execution Environment.'}</Text>
          </Box>
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Start Maple desktop app → API Management → Local Proxy → Start Proxy.</Text>
          </Box>
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>{'⚠  Note: Maple defaults to port 8080 — same as our relay.'}</Text>
          </Box>
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Configure Maple to use port 8081 in its settings, then continue.</Text>
          </Box>
          <Prompt label="Maple API key (blank = desktop auto-auth)" value={input} onChange={setInput}
            onSubmit={v => { set('mapleApiKey', v || 'maple-desktop-auto'); advance('mapleBase'); }} mask />
        </Box>
      )}
      {field === 'mapleBase' && (
        <Prompt
          label="Maple proxy URL"
          placeholder="http://localhost:8081"
          value={input}
          onChange={setInput}
          onSubmit={v => { set('mapleBase', (v || 'http://localhost:8081') + '/v1'); advance('editor'); }}
        />
      )}

      {/* Ollama — local models */}
      {field === 'ollamaModel' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            {probing ? (
              <Text color={P.muted}>Checking for Ollama on localhost:11434…</Text>
            ) : ollamaModels === null ? (
              <Box flexDirection="column">
                <Text color={P.warn}>⚠  Ollama not detected on localhost:11434</Text>
                <Text color={P.muted}>Install from ollama.com, then type a model name below.</Text>
              </Box>
            ) : ollamaModels.length === 0 ? (
              <Box flexDirection="column">
                <Text color={P.warn}>⚠  Ollama running but no models pulled</Text>
                <Text color={P.muted}>Run: ollama pull llama3  then type model name below.</Text>
              </Box>
            ) : (
              <Text color={P.success}>✓ Ollama detected — {ollamaModels.length} model(s) available</Text>
            )}
          </Box>
          {ollamaModels && ollamaModels.length > 0 ? (
            <Select
              label="Select model"
              options={ollamaModels.map(m => ({ label: m, value: m }))}
              onSelect={item => { set('ollamaModel', item.value); advance('ollamaBase'); }}
            />
          ) : (
            <Prompt label="Model name" placeholder="llama3" value={input}
              onChange={setInput}
              onSubmit={v => { set('ollamaModel', v || 'llama3'); advance('ollamaBase'); }} />
          )}
        </Box>
      )}
      {field === 'ollamaBase' && (
        <Prompt label="Ollama base URL" placeholder="http://localhost:11434" value={input}
          onChange={setInput}
          onSubmit={v => { set('ollamaBase', v || 'http://localhost:11434'); advance('editor'); }} />
      )}

      {/* LM Studio — local models */}
      {field === 'lmstudioModel' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            {probing ? (
              <Text color={P.muted}>Checking for LM Studio on localhost:1234…</Text>
            ) : lmstudioModels === null ? (
              <Box flexDirection="column">
                <Text color={P.warn}>⚠  LM Studio not detected on localhost:1234</Text>
                <Text color={P.muted}>Start LM Studio → Local Server, then type model name below.</Text>
              </Box>
            ) : lmstudioModels.length === 0 ? (
              <Box flexDirection="column">
                <Text color={P.warn}>⚠  LM Studio running but no models loaded</Text>
                <Text color={P.muted}>Load a model in LM Studio first, then type its name below.</Text>
              </Box>
            ) : (
              <Text color={P.success}>✓ LM Studio detected — {lmstudioModels.length} model(s) loaded</Text>
            )}
          </Box>
          {lmstudioModels && lmstudioModels.length > 0 ? (
            <Select
              label="Select model"
              options={lmstudioModels.map(m => ({ label: m, value: m }))}
              onSelect={item => { set('lmstudioModel', item.value); advance('lmstudioBase'); }}
            />
          ) : (
            <Prompt label="Model name" placeholder="local-model" value={input}
              onChange={setInput}
              onSubmit={v => { set('lmstudioModel', v || 'local-model'); advance('lmstudioBase'); }} />
          )}
        </Box>
      )}
      {field === 'lmstudioBase' && (
        <Prompt label="LM Studio base URL" placeholder="http://localhost:1234" value={input}
          onChange={setInput}
          onSubmit={v => { set('lmstudioBase', v || 'http://localhost:1234'); advance('editor'); }} />
      )}

      {/* Custom endpoint — any OpenAI-compatible API */}
      {field === 'customApiBase' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Any OpenAI-compatible API.</Text>
          </Box>
          <Prompt label="Base URL" placeholder="http://localhost:11434/v1" value={input}
            onChange={setInput}
            onSubmit={v => { set('customApiBase', v); advance('customApiKey'); }} />
        </Box>
      )}
      {field === 'customApiKey' && (
        <Prompt label="API key (blank if not required)" value={input} onChange={setInput}
          onSubmit={v => { set('customApiKey', v || 'none'); advance('customModel'); }} mask />
      )}
      {field === 'customModel' && (
        <Prompt label="Model name" value={input} onChange={setInput}
          onSubmit={v => { set('customModel', v); advance('editor'); }} />
      )}

      {/* AI coding tool — determines which filename the context file is symlinked to */}
      {field === 'editor' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>
              {'Nostr Station writes a '}
            </Text>
            <Text color={P.accentBright}>NOSTR_STATION.md</Text>
            <Text color={P.muted}>
              {' context file and symlinks it\n  to your tool\'s convention. Switch any time: '}
            </Text>
            <Text color={P.accentBright}>nostr-station setup-editor</Text>
          </Box>
          <Select
            label="AI coding tool"
            options={EDITORS}
            onSelect={item => { set('editor', item.value); advance('installStacks'); }}
          />
        </Box>
      )}

      {/* Optional components */}
      {field === 'installStacks' && (
        <Box flexDirection="column">
          <Box marginLeft={2} marginBottom={1}>
            <Text color={P.muted}>Stacks by Soapbox — scaffold Nostr apps with </Text>
            <Text color={P.accentBright}>stacks mkstack</Text>
            <Text color={P.muted}> + Dork AI agent</Text>
          </Box>
          <Select label="Install Stacks? (@getstacks/stacks)" options={YES_NO}
            onSelect={item => { set('installStacks', item.value); advance('installBlossom'); }} />
        </Box>
      )}

      {field === 'installBlossom' && (
        <Select label="Install Blossom media server (dev only)?" options={YES_NO}
          onSelect={item => { set('installBlossom', item.value); advance('installLlmWiki'); }} />
      )}

      {field === 'installLlmWiki' && (
        <Select label="Install llm-wiki Claude Code plugin?" options={YES_NO}
          onSelect={item => {
            set('installLlmWiki', item.value);
            done({ ...values, installLlmWiki: item.value });
          }} />
      )}
    </Box>
  );
};
