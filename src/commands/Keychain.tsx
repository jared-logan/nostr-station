import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { P } from '../cli-ui/palette.js';
import {
  getKeychain, getKeychainBackendName,
  ALL_KEYS, type KeychainKey,
} from '../lib/keychain.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

type KeychainAction = 'list' | 'get' | 'set' | 'delete' | 'rotate' | 'migrate';

interface KeychainProps {
  action: KeychainAction;
  // `key` would be the natural name but React treats it as a reconciliation
  // hint and strips it from props — the inner component sees undefined and
  // Ink logs a runtime warning. Stick with credKey to match the child
  // components' prop names.
  credKey?: string;
}

// ── List ───────────────────────────────────────────────────────────────────

const KeychainList: React.FC = () => {
  const [rows, setRows] = useState<{ key: string; present: boolean }[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const kc = getKeychain();
      const results = await Promise.all(
        ALL_KEYS.map(async k => ({ key: k, present: (await kc.retrieve(k)) !== null }))
      );
      setRows(results);
      setDone(true);
    })();
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station keychain list</Text>
      </Box>
      <Text color={P.muted}>Backend: {getKeychainBackendName()}</Text>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      {rows.map((r, i) => (
        <Box key={i}>
          <Box width={20}><Text>{r.key}</Text></Box>
          <Text color={r.present ? P.success : P.muted}>
            {r.present ? '✓ stored' : '○ not set'}
          </Text>
        </Box>
      ))}
      {done && <Text color={P.accentDim}>{'─────────────────────────────'}</Text>}
    </Box>
  );
};

// ── Get ────────────────────────────────────────────────────────────────────

const KeychainGet: React.FC<{ credKey: string }> = ({ credKey }) => {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    (async () => {
      const v = await getKeychain().retrieve(credKey as KeychainKey);
      setValue(v);
    })();
  }, []);

  // Missing credential is a non-zero exit — matches `keychain get --raw`
  // so scripts get a consistent signal regardless of which variant they
  // use.
  useEffect(() => {
    if (value === null) process.exitCode = 1;
  }, [value]);

  useInput((input) => {
    if (value !== undefined && !confirmed) {
      if (input === 'y' || input === 'Y') setConfirmed(true);
      else process.exit(0);
    }
  });

  if (value === undefined) return <Text color={P.muted}>retrieving…</Text>;

  if (value === null) {
    return (
      <Box paddingX={1}>
        <Text color={P.error}>{credKey}: not found in keychain</Text>
      </Box>
    );
  }

  if (!confirmed) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={P.warn}>Display credential value for <Text bold>{credKey}</Text>? [y/N]</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Box width={20}><Text color={P.muted}>{credKey}</Text></Box>
        <Text>{value}</Text>
      </Box>
    </Box>
  );
};

// ── Set ────────────────────────────────────────────────────────────────────

const KeychainSet: React.FC<{ credKey: string }> = ({ credKey }) => {
  const [input, setInput] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (val: string) => {
    if (!val.trim()) { setError('Value cannot be empty.'); return; }
    try {
      await getKeychain().store(credKey as KeychainKey, val.trim());
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (done) {
    return (
      <Box paddingX={1}>
        <Text color={P.success}>✓ {credKey} stored in {getKeychainBackendName()}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={P.muted}>Backend: {getKeychainBackendName()}</Text>
      <Box marginTop={1}>
        <Text color={P.accent}>{credKey}: </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          mask="*"
          placeholder="(input hidden)"
        />
      </Box>
      {error && <Text color={P.error}>{error}</Text>}
    </Box>
  );
};

// ── Delete ─────────────────────────────────────────────────────────────────

const KeychainDelete: React.FC<{ credKey: string }> = ({ credKey }) => {
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState(false);

  useInput((input) => {
    if (!confirmed && !done) {
      if (input === 'y' || input === 'Y') {
        setConfirmed(true);
        getKeychain().delete(credKey as KeychainKey).then(() => setDone(true));
      } else {
        process.exit(0);
      }
    }
  });

  if (done) {
    return (
      <Box paddingX={1}>
        <Text color={P.success}>✓ {credKey} deleted from keychain</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color={P.warn}>Delete <Text bold>{credKey}</Text> from keychain? [y/N]</Text>
    </Box>
  );
};

// ── Rotate ─────────────────────────────────────────────────────────────────

const KeychainRotate: React.FC<{ credKey: string; rollback: boolean }> = ({ credKey, rollback }) => {
  const [phase, setPhase] = useState<'input' | 'countdown' | 'done' | 'rolledback'>('input');
  const [input, setInput] = useState('');
  const [countdown, setCountdown] = useState(60);
  const [error, setError] = useState('');
  const oldValueRef = useRef<string | null>(null);

  useEffect(() => {
    if (rollback) {
      (async () => {
        if (oldValueRef.current) {
          await getKeychain().store(credKey as KeychainKey, oldValueRef.current);
          setPhase('rolledback');
        } else {
          setError('No previous value to roll back to (must run in same session).');
        }
      })();
    }
  }, []);

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown <= 0) { setPhase('done'); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const handleSubmit = async (val: string) => {
    if (!val.trim()) { setError('Value cannot be empty.'); return; }
    try {
      oldValueRef.current = await getKeychain().retrieve(credKey as KeychainKey);
      await getKeychain().store(credKey as KeychainKey, val.trim());
      setPhase('countdown');
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (rollback) {
    if (phase === 'rolledback') {
      return <Box paddingX={1}><Text color={P.success}>✓ Rolled back to previous value.</Text></Box>;
    }
    if (error) return <Box paddingX={1}><Text color={P.error}>{error}</Text></Box>;
    return <Box paddingX={1}><Text color={P.muted}>Rolling back…</Text></Box>;
  }

  if (phase === 'input') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={P.muted}>Rotating: <Text bold>{credKey}</Text></Text>
        <Text color={P.muted}>Old value will be kept as fallback for 60 seconds.</Text>
        <Box marginTop={1}>
          <Text color={P.accent}>New value: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} mask="*" placeholder="(input hidden)" />
        </Box>
        {error && <Text color={P.error}>{error}</Text>}
      </Box>
    );
  }

  if (phase === 'countdown') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={P.success}>✓ New value stored.</Text>
        <Text color={P.muted}>Old value kept as fallback for <Text bold color="white">{countdown}s</Text>.</Text>
        <Text color={P.muted}>If something broke: <Text color={P.accentBright}>nostr-station keychain rotate --rollback</Text></Text>
      </Box>
    );
  }

  if (phase === 'done') {
    return (
      <Box paddingX={1}>
        <Text color={P.success}>✓ Rotation complete. Old fallback cleared.</Text>
      </Box>
    );
  }

  return null;
};

// ── Migrate ────────────────────────────────────────────────────────────────

const KeychainMigrate: React.FC = () => {
  const [lines, setLines] = useState<{ text: string; ok: boolean }[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const envPath = path.join(os.homedir(), '.claude_env');
      const out: { text: string; ok: boolean }[] = [];

      if (!fs.existsSync(envPath)) {
        out.push({ text: '~/.claude_env not found — nothing to migrate.', ok: false });
        setLines(out); setDone(true); return;
      }

      const content = fs.readFileSync(envPath, 'utf8');

      // Already a loader script?
      if (content.includes('nostr-station keychain get')) {
        out.push({ text: '~/.claude_env is already a keychain loader — no migration needed.', ok: true });
        setLines(out); setDone(true); return;
      }

      // Extract API key
      const keyMatch = content.match(/export ANTHROPIC_API_KEY="([^"]+)"/);
      if (!keyMatch) {
        out.push({ text: 'No ANTHROPIC_API_KEY found in ~/.claude_env.', ok: false });
        setLines(out); setDone(true); return;
      }

      const apiKey = keyMatch[1];
      if (apiKey === 'ollama' || apiKey === 'lm-studio') {
        out.push({ text: `Provider uses local server (${apiKey}) — no keychain migration needed.`, ok: true });
        setLines(out); setDone(true); return;
      }

      // Store in keychain
      try {
        await getKeychain().store('ai-api-key', apiKey);
        out.push({ text: `✓ API key stored in ${getKeychainBackendName()}`, ok: true });
      } catch (e: any) {
        out.push({ text: `✗ Couldn't store in keychain — ${e.message}`, ok: false });
        setLines(out); setDone(true); return;
      }

      // Overwrite ~/.claude_env — replace only the key line, preserve BASE_URL and MODEL
      const newContent = content.replace(
        /export ANTHROPIC_API_KEY="[^"]+"/,
        `export ANTHROPIC_API_KEY="$(nostr-station keychain get ai-api-key --raw 2>/dev/null)"`
      );
      const header = `# ~/.claude_env — no secrets, safe to inspect\n# API key is stored in: ${getKeychainBackendName()}\n`;
      fs.writeFileSync(envPath, header + newContent.replace(/^#[^\n]*\n/gm, ''));
      out.push({ text: '✓ ~/.claude_env rewritten as keychain loader', ok: true });
      out.push({ text: '', ok: true });
      out.push({ text: 'Run: source ~/.claude_env  to reload the current session.', ok: true });

      setLines(out); setDone(true);
    })();
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station keychain migrate</Text>
      </Box>
      {lines.map((l, i) => (
        <Text key={i} color={l.text === '' ? undefined : l.ok ? 'white' : P.error}>{l.text}</Text>
      ))}
      {!done && <Text color={P.muted}>working…</Text>}
    </Box>
  );
};

// ── Root component ─────────────────────────────────────────────────────────

export const Keychain: React.FC<KeychainProps> = ({ action, credKey }) => {
  switch (action) {
    case 'list':    return <KeychainList />;
    case 'get':     return <KeychainGet credKey={credKey ?? 'ai-api-key'} />;
    case 'set':     return <KeychainSet credKey={credKey ?? 'ai-api-key'} />;
    case 'delete':  return <KeychainDelete credKey={credKey ?? 'ai-api-key'} />;
    case 'rotate':  return <KeychainRotate credKey={credKey ?? 'ai-api-key'} rollback={process.argv.includes('--rollback')} />;
    case 'migrate': return <KeychainMigrate />;
    default:        return <KeychainList />;
  }
};
